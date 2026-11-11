import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CURRENT_DATA_HOME_LEAF, DATA_HOME_ENTRIES, DATA_HOME_ENV, STORE_MARKERS,
  dataHome, holdsStore, isDataHomeError, resolveDataHome,
} from '../shared/data-home.mjs';
import { SERVICE_EXECUTOR_FAULT_FILE, SERVICE_INFO_FILE, SERVICE_ROLL_FILE, SERVICE_SOCKET_FILE, SERVICE_STARTUP_FAILURE_FILE, serviceInfoPath } from '../service/transport/identity';

/**
 * The one data-home resolver. The data home is `~/.nucleus`, or `NUCLEUS_DATA_HOME`
 * when set. Tom, 2026-11-09: retire the move machinery. Every case runs in a
 * throwaway fixture under TMPDIR: nothing here reads or writes a real data home.
 */

interface Fixture { root: string; home: string }

function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-data-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

/** A store is a directory holding at least one marker; the marker's contents never matter here. */
function store(dir: string, marker = 'queue.sqlite'): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, marker), '');
  return dir;
}

const currentOf = (home: string) => join(home, CURRENT_DATA_HOME_LEAF);

/** Resolve or catch, so a case can assert on a refusal as easily as on a path. */
function attempt(env: NodeJS.ProcessEnv): { root?: string; refusal?: string; message?: string } {
  try {
    return { root: dataHome(env) };
  } catch (error) {
    return { refusal: (error as { code?: string }).code, message: (error as Error).message };
  }
}

test('~/.nucleus is the default and the only place a new store is created', t => {
  const { home } = fixture(t);
  assert.equal(dataHome({ HOME: home }), currentOf(home));
  assert.deepEqual(resolveDataHome({ HOME: home }), { root: currentOf(home), source: 'default' });
  assert.equal(DATA_HOME_ENTRIES.some(entry => entry.path === 'queue.sqlite'), true);
  assert.equal(CURRENT_DATA_HOME_LEAF, '.nucleus');
  assert.equal(DATA_HOME_ENV, 'NUCLEUS_DATA_HOME');
});

test('the resolver keeps the path shapes the CLI and service already use', () => {
  assert.equal(dataHome({ HOME: '/workspace/a' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: ' /workspace/b ' }), '/workspace/b/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/./a' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/a', PASEO_HOME: '/custom/' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/a', PASEO_HOME: '/custom//home' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/a', PASEO_HOME: '/a/../b' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/a', PASEO_HOME: '' }), '/workspace/a/.nucleus');
  assert.equal(dataHome({ HOME: '/workspace/a', [DATA_HOME_ENV]: '' }), '/workspace/a/.nucleus');
});

test('an existing store at ~/.nucleus keeps its folder', t => {
  const { home } = fixture(t);
  const current = store(currentOf(home));
  for (const path of ['settings.json', 'runners.json', 'queue-service.json', 'queue-service-roll.json', 'queue-service-executor-fault.json'])
    writeFileSync(join(current, path), '{}');
  for (const dir of ['tickets', 'backups', 'isolation', 'queue-hooks', 'profiles']) mkdirSync(join(current, dir), { recursive: true });
  writeFileSync(join(current, 'operator-notes.txt'), 'not ours');
  assert.deepEqual(resolveDataHome({ HOME: home }), { root: current, source: 'store' });
  const kind = (path: string) => DATA_HOME_ENTRIES.find(entry => entry.path === path)?.kind;
  for (const path of ['queue.sqlite', 'settings.json', 'queue-service.json', 'tickets/', 'backups/', 'isolation/', 'queue-hooks/', 'profiles/'])
    assert.equal(kind(path), 'durable', `${path} is durable`);
  assert.equal(DATA_HOME_ENTRIES.some(entry => entry.path === 'operator-notes.txt'), false);
  assert.equal(kind('runners.json'), undefined, 'retired state is copied as an unknown durable entry');
});

test('an empty ~/.nucleus is still the creation default', t => {
  const { home } = fixture(t);
  const current = currentOf(home);
  mkdirSync(current, { recursive: true });
  assert.deepEqual(resolveDataHome({ HOME: home }), { root: current, source: 'default' });
});

test('a directory at ~/.nucleus is only a store when it holds a Nucleus marker', t => {
  const { home } = fixture(t);
  const current = currentOf(home);
  mkdirSync(join(current, 'config'), { recursive: true });
  mkdirSync(join(current, 'state'), { recursive: true });
  writeFileSync(join(current, 'config', 'ui.json'), '{}');
  writeFileSync(join(current, 'state', 'nucleus.sqlite'), '');
  assert.equal(holdsStore(current), false);
  const refused = attempt({ HOME: home });
  assert.equal(refused.refusal, 'data-home:occupied');
  assert.match(String(refused.message), new RegExp(current));
  assert.match(String(refused.message), new RegExp(DATA_HOME_ENV));
  assert.deepEqual(STORE_MARKERS, ['queue.sqlite', 'settings.json', 'queue-service.json']);
  for (const marker of STORE_MARKERS) {
    const dir = store(join(home, `marker-${marker}`), marker);
    assert.equal(holdsStore(dir), true, `${marker} marks a store`);
  }
});

test('the live leftover layout resolves to ~/.nucleus and never opens the journal', t => {
  const { home } = fixture(t);
  const current = store(currentOf(home));
  const journal = join(home, '.nucleus-stage-journal.json');
  writeFileSync(journal, JSON.stringify({
    version: 1, cutover: true, phase: 'published',
    source: join(home, '.paseo', 'northstar-queue'), destination: current,
    inventory: Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}` })),
  }));
  const sealed = join(home, '.paseo', 'northstar-queue');
  mkdirSync(sealed, { recursive: true });
  writeFileSync(join(sealed, '.nucleus-redirect.json'), JSON.stringify({ to: current }));
  writeFileSync(join(sealed, 'queue.sqlite'), 'sealed');
  const script = join(home, 'journal-access.mjs');
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../shared/data-home.mjs')).href;
  writeFileSync(script, `
    import fs from 'node:fs';
    import { resolve as resolvePath } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const journal = ${JSON.stringify(resolve(journal))};
    const accessed = [];
    const asPath = (value) => {
      if (typeof value === 'string' || Buffer.isBuffer(value)) return resolvePath(String(value));
      if (value instanceof URL) return resolvePath(fileURLToPath(value));
      return null;
    };
    const record = (method, args) => {
      for (const arg of args) {
        const path = asPath(arg);
        if (path === journal) accessed.push({ method, path });
      }
    };
    const wrap = (obj) => {
      for (const name of Object.getOwnPropertyNames(obj)) {
        const desc = Object.getOwnPropertyDescriptor(obj, name);
        if (!desc || typeof desc.value !== 'function') continue;
        if (desc.value._nucleusJournalProbe) continue;
        const original = desc.value;
        const probed = function (...args) {
          record(name, args);
          return original.apply(this, args);
        };
        probed._nucleusJournalProbe = true;
        obj[name] = probed;
      }
    };
    wrap(fs);
    if (fs.promises) wrap(fs.promises);
    for (const name of ['open', 'openSync', 'readFile', 'readFileSync', 'stat', 'statSync', 'readdir', 'readdirSync']) {
      if (typeof fs[name] === 'function' && !fs[name]._nucleusJournalProbe) {
        throw new Error('failed to instrument fs.' + name);
      }
    }
    const originalBuiltin = process.getBuiltinModule.bind(process);
    process.getBuiltinModule = (name) => {
      const mod = originalBuiltin(name);
      if ((name === 'node:fs' || name === 'fs') && mod) {
        wrap(mod);
        if (mod.promises) wrap(mod.promises);
      }
      return mod;
    };
    const { resolveDataHome } = await import(${JSON.stringify(moduleUrl)});
    const result = resolveDataHome({
      HOME: ${JSON.stringify(home)},
      PASEO_HOME: ${JSON.stringify(join(home, '.paseo'))},
    });
    console.log(JSON.stringify({ result, accessed }));
  `);
  const printed = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  const { result, accessed } = JSON.parse(printed.stdout) as {
    result: { root: string; source: string };
    accessed: unknown[];
  };
  assert.deepEqual(result, { root: current, source: 'store' });
  assert.deepEqual(accessed, [], 'the leftover journal is never opened or read');
});

test('PASEO_HOME is ignored even when it holds a store', t => {
  const { home, root } = fixture(t);
  const current = currentOf(home);
  const paseoStore = store(join(root, 'paseo', 'northstar-queue'));
  assert.equal(dataHome({ HOME: home, PASEO_HOME: join(root, 'paseo') }), current);
  assert.equal(attempt({ HOME: home, PASEO_HOME: join(root, 'paseo') }).root, current);
  assert.notEqual(paseoStore, current);
});

test('an unreadable ~/.nucleus is refused, never reported as an empty one', t => {
  const { home } = fixture(t);
  const current = currentOf(home);
  mkdirSync(current, { recursive: true });
  chmodSync(current, 0o000);
  const refused = attempt({ HOME: home });
  chmodSync(current, 0o700);
  assert.equal(refused.root, undefined, 'the unreadable folder is not read as "no store"');
  assert.equal(refused.refusal, 'data-home:unreadable');
  assert.match(String(refused.message), new RegExp(current));
  assert.match(String(refused.message), /EACCES/);
});

test('NUCLEUS_DATA_HOME selects the whole data home and skips the marker check', t => {
  const { home, root } = fixture(t);
  const chosen = join(root, 'chosen');
  assert.equal(dataHome({ HOME: home, [DATA_HOME_ENV]: chosen }), chosen);
  assert.deepEqual(resolveDataHome({ HOME: home, [DATA_HOME_ENV]: chosen }), { root: chosen, source: 'override' });
  assert.equal(dataHome({ HOME: home, [DATA_HOME_ENV]: `${chosen}//.` }), chosen);
  store(currentOf(home));
  assert.equal(dataHome({ HOME: home, [DATA_HOME_ENV]: chosen }), chosen);
  assert.equal(dataHome({ HOME: home, [DATA_HOME_ENV]: chosen, PASEO_HOME: join(root, 'elsewhere') }), chosen);
  assert.throws(() => dataHome({ HOME: home, [DATA_HOME_ENV]: '~/nucleus' }), error => isDataHomeError(error) && (error as { code?: string }).code === 'data-home:tilde');
});

test('service identity reads the store the resolver chose', t => {
  const { home } = fixture(t);
  store(currentOf(home));
  const dir = dataHome({ HOME: home });
  assert.equal(dir, currentOf(home));
  assert.equal(serviceInfoPath(dir), join(currentOf(home), SERVICE_INFO_FILE));
  for (const name of [SERVICE_SOCKET_FILE, SERVICE_INFO_FILE, SERVICE_ROLL_FILE, SERVICE_STARTUP_FAILURE_FILE, SERVICE_EXECUTOR_FAULT_FILE]) {
    assert.ok(DATA_HOME_ENTRIES.some(entry => entry.path === name), `${name} is in the data-home inventory`);
  }
});

test('the inventory names every path under a data home, with one owner each', () => {
  const paths = DATA_HOME_ENTRIES.map(entry => entry.path);
  assert.equal(new Set(paths).size, paths.length, 'no path is listed twice');
  for (const entry of DATA_HOME_ENTRIES) {
    assert.equal(entry.path.startsWith('/'), false, `${entry.path} is relative to the data home`);
    assert.equal(entry.path.includes('..'), false, `${entry.path} stays inside the data home`);
    assert.equal(['durable', 'ephemeral', 'derived'].includes(entry.kind), true, `${entry.path} has a known kind`);
    assert.equal(typeof entry.owner === 'string' && entry.owner.length > 0, true, `${entry.path} names its owner`);
  }
  const kind = (path: string) => DATA_HOME_ENTRIES.find(entry => entry.path === path)?.kind;
  for (const path of ['queue.sqlite', 'queue.sqlite-wal', 'queue.sqlite-shm', 'settings.json', 'profiles/', 'tickets/', 'backups/', 'isolation/', 'queue-hooks/', 'project-qa/', 'project-validation/'])
    assert.equal(kind(path), 'durable', `${path} is durable`);
  for (const path of ['callback.sock', 'queue-service.sock', 'queue-service.claim.json', 'queue-standby-<pid>.ready', 'queue-service-<pid>.maintenance', 'host-run/', 'run/'])
    assert.equal(kind(path), 'ephemeral', `${path} is ephemeral`);
  for (const path of ['worker-report.mjs', 'oversize-response.json']) assert.equal(kind(path), 'derived', `${path} is derived`);
});

test('the CLI prints the resolution and the inventory', t => {
  const { home } = fixture(t);
  store(currentOf(home));
  const env = { ...process.env, HOME: home, [DATA_HOME_ENV]: '' };
  const printed = spawnSync(process.execPath, ['bin/nucleus.mjs', 'data-home'], { env, encoding: 'utf8', cwd: resolve(import.meta.dirname, '..') });
  assert.equal(printed.status, 0, printed.stderr);
  const resolution = JSON.parse(printed.stdout);
  assert.equal(resolution.root, currentOf(home));
  assert.equal(resolution.source, 'store');
  assert.equal(resolution.entry, undefined);
  assert.equal(resolution.legacy, undefined);
  assert.equal(resolution.stores, undefined);
  assert.deepEqual(resolution.entries.map((entry: { path: string }) => entry.path), DATA_HOME_ENTRIES.map(entry => entry.path));
});

test('the CLI names an occupied unrelated ~/.nucleus instead of adopting it', t => {
  const { home } = fixture(t);
  const current = currentOf(home);
  mkdirSync(join(current, 'config'), { recursive: true });
  writeFileSync(join(current, 'config', 'ui.json'), '{}');
  const env = { ...process.env, HOME: home, [DATA_HOME_ENV]: '' };
  const refused = spawnSync(process.execPath, ['bin/nucleus.mjs', 'data-home'], { env, encoding: 'utf8', cwd: resolve(import.meta.dirname, '..') });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout.trim(), '');
  assert.match(refused.stderr, /exists and is not a Nucleus store/);
  assert.match(refused.stderr, new RegExp(DATA_HOME_ENV));
});

test('resolution for process.env is computed once', t => {
  const { home } = fixture(t);
  const current = store(currentOf(home));
  const script = join(home, 'once.mjs');
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../shared/data-home.mjs')).href;
  writeFileSync(script, `
    import { resolveDataHome } from ${JSON.stringify(moduleUrl)};
    import { rmSync } from 'node:fs';
    import { join } from 'node:path';
    const first = resolveDataHome();
    rmSync(join(process.env.HOME, '.nucleus'), { recursive: true, force: true });
    const second = resolveDataHome();
    console.log(JSON.stringify({ first, second }));
  `);
  const printed = spawnSync(process.execPath, [script], {
    env: { ...process.env, HOME: home, [DATA_HOME_ENV]: '' },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  const { first, second } = JSON.parse(printed.stdout) as { first: { root: string; source: string }; second: { root: string; source: string } };
  assert.deepEqual(first, { root: current, source: 'store' });
  assert.deepEqual(second, first, 'a second call reuses the first answer after the store is gone');
});
