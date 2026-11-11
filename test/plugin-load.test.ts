import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

/**
 * The Paseo plugin host loads the plugin as a CJS bundle, where `import.meta` is
 * empty. Every other check runs the code as ESM — node, tsx, the unit suites — so
 * a module-scope construct that only works in ESM passes all of them and then
 * fails the real plugin load on the next roll. This test loads the entry the way
 * the host does, so that class of error fails here instead.
 */
test('the plugin entry loads in the host CJS bundle format', async () => {
  const root = resolve(import.meta.dirname, '..');
  assert.equal(JSON.parse(readFileSync(join(root, 'paseo-plugin.json'), 'utf8')).id, 'nucleus', 'default installs must use the bridge discovery ID');
  assert.equal(readFileSync(join(root, 'paseo-plugin.json'), 'utf8'), readFileSync(join(root, 'hosts/paseo/plugin/paseo-plugin.json'), 'utf8'), 'source loading and installed packages use the same manifest');
  const dir = mkdtempSync(join(tmpdir(), 'nsp'));
  const outfile = join(dir, 'plugin.cjs');
  const identityPath = join(dir, 'home', '.nucleus', 'queue-service.json');
  try {
    await build({
      entryPoints: [resolve(root, 'index.server.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent',
    });
    // Required in a child process so the failure surfaces as an exit status and as
    // the host's own message, rather than as a rejected import in this suite.
    const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(outfile)})`], { encoding: 'utf8' });
    assert.equal(run.status, 0, `the bundled plugin entry must load: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /Invalid URL|import.meta/, 'the entry must not depend on a module URL');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { nucleus: { path: root } } }));
    // A fixture home keeps the resolver off the operator's real data home.
    // PASEO_HOME stays the app home under test; the data home is HOME/.nucleus.
    mkdirSync(join(dir, 'home'), { recursive: true });
    const fixtureEnv = { ...process.env, HOME: join(dir, 'home'), PASEO_HOME: dir, NUCLEUS_DATA_HOME: '' };
    const startup = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const dispose = require(${JSON.stringify(outfile)}).default({ handle() {}, on() {} });
      const identity = ${JSON.stringify(identityPath)};
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        if (fs.existsSync(identity)) { clearInterval(timer); dispose(); process.exit(0); }
        if (Date.now() > deadline) { clearInterval(timer); dispose(); process.exit(1); }
      }, 100);
    `], { encoding: 'utf8', timeout: 20000, cwd: root, env: fixtureEnv });
    assert.equal(startup.status, 0, `registration must start a service without a board read or callback: ${startup.stderr}`);

    // A config that still names the retired `northstar-queue` ID is ignored, not
    // migrated: the bundle keeps running (discovery answers nucleus from the
    // first phase's registration), and no second bridge or refusal appears.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ plugins: { 'northstar-queue': { path: root } } }));
    const retiredOnly = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const dispose = require(${JSON.stringify(outfile)}).default({ handle() {}, on() {} });
      const identity = ${JSON.stringify(identityPath)};
      const deadline = Date.now() + 15000;
      const timer = setInterval(() => {
        if (fs.existsSync(identity)) { clearInterval(timer); dispose(); process.exit(0); }
        if (Date.now() > deadline) { clearInterval(timer); dispose(); process.exit(1); }
      }, 100);
    `], { encoding: 'utf8', timeout: 20000, cwd: root, env: fixtureEnv });
    assert.equal(retiredOnly.status, 0, `a retired-ID-only config is ignored, and the service identity stays readable: ${retiredOnly.stderr}`);

  } finally {
    try {
      const info = JSON.parse(readFileSync(identityPath, 'utf8'));
      if (info.pid !== process.pid) {
        process.kill(info.pid, 'SIGTERM');
        // The service may still be writing (a startup backup) until it exits.
        for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
          try { process.kill(info.pid, 0); } catch { break; }
          await new Promise(done => setTimeout(done, 50));
        }
      }
    } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
