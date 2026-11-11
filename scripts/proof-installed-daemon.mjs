import { scratchDirectory } from '../shared/scratch-root.mjs';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { proveInstalledClient } from './proof-installed-client.mjs';

const execFile = promisify(execFileCallback);
scratchDirectory(tmpdir());
// Leave room for the host-run inner socket's PID/token within macOS sun_path.
const root = await mkdtemp(`${resolve(tmpdir())}/`);
const home = join(root, 'h'), paseoHome = root, dataHome = join(home, '.nucleus');
assert.notEqual(resolve(home), resolve(userInfo().homedir));
assert.notEqual(resolve(home), resolve(homedir()));
await mkdir(home);
const env = { ...process.env, HOME: home, PASEO_HOME: paseoHome, TMPDIR: root, TMP: root, TEMP: root,
  NODE_OPTIONS: '', NODE_PATH: '', PASEO_DICTATION_ENABLED: 'false', NUCLEUS_SKILL_DIRS: join(root, 'skills'),
  NUCLEUS_TICKET: '', NUCLEUS_RUN_TOKEN: '', NORTHSTAR_RUN_TOKEN: '' };
delete env.NUCLEUS_DATA_HOME;
const run = (cmd, args, timeout = 120_000) => execFile(cmd, args, { env, cwd: root, timeout, maxBuffer: 8 * 1024 * 1024 });
const repo = process.cwd(), build = join(root, 'package'), tarball = join(root, 'package.tar.gz');
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === '--release-directory'), 'Usage: effigy proof:installed-daemon -- [--release-directory <prepared-output>]');
if (args.length) {
  const directory = await realpath(resolve(args[1]));
  scratchDirectory(directory);
  const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const name = `nucleus-${version}-darwin-arm64.tar.gz`;
  const manifest = JSON.parse(await readFile(join(directory, 'nucleus-darwin-arm64.json'), 'utf8'));
  assert.equal(manifest.url, `https://github.com/inflatable-cookie/nucleus/releases/download/v${version}/${name}`);
  const archive = await readFile(join(directory, name));
  assert.equal(createHash('sha256').update(archive).digest('hex'), manifest.sha256);
  const key = join(root, 'loopback.key'), cert = join(root, 'loopback.crt'), config = join(root, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config]);
  env.NODE_EXTRA_CA_CERTS = cert;
  let manifestRequests = 0, archiveRequests = 0;
  const https = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.url === '/nucleus-darwin-arm64.json') {
      manifestRequests++;
      res.end(JSON.stringify({ ...manifest, url: `https://127.0.0.1:${https.address().port}/${name}` }));
    } else if (req.url === `/${name}`) { archiveRequests++; res.end(archive); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => https.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    await run(join(directory, 'package/runtime/node'), [join(directory, 'package/bin/nucleus.mjs'), 'install', `https://127.0.0.1:${https.address().port}/nucleus-darwin-arm64.json`]);
    assert.equal(manifestRequests, 1);
    assert.equal(archiveRequests, 1);
    console.log(`install=loopback-https-manifest sha256=${manifest.sha256} artifacts=${directory}`);
  } finally {
    await new Promise((resolve, reject) => https.close(error => error ? reject(error) : resolve()));
    delete env.NODE_EXTRA_CA_CERTS;
  }
} else {
  await run(process.execPath, [join(repo, 'scripts/build-runtime.mjs'), build]);
  await run('/usr/bin/tar', ['--format=ustar', '-czf', tarball, '-C', build, '.']);
  await run(process.execPath, [join(repo, 'bin/nucleus.mjs'), 'install', tarball]);
}
const nucleus = join(home, '.local/bin/nucleus');
const version = JSON.parse((await run(nucleus, ['version'])).stdout);
assert.equal(version.version, JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version);
assert.equal(version.revision, (await run('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim());
assert.equal(version.channel, 'release');
assert.equal(version.dataHome, dataHome);
const resolved = JSON.parse((await run(nucleus, ['data-home'])).stdout);
assert.equal(resolved.root, dataHome);
assert.equal(resolved.source, 'default');
console.log(`version=${version.version} revision=${version.revision} data-home=${resolved.root} scratch=${root}`);
await run(nucleus, ['integrate', 'paseo']);
await proveInstalledClient(join(home, '.local/share/nucleus/current'));
// A private repository with no links to the source checkout; main advances only here.
const source = join(root, 'source');
const branch = (await run('git', ['-C', repo, 'branch', '--show-current'])).stdout.trim();
await run('git', ['clone', '--no-local', '--single-branch', '--branch', branch, '--', repo, source]);
await run('git', ['-C', source, 'remote', 'remove', 'origin']);
await run('git', ['-C', source, 'branch', '-M', 'main']);
await run(nucleus, ['channel', 'main', source, root]);
const current = join(home, '.local/share/nucleus/current');
const installed = await realpath(current);
assert.ok(installed.startsWith(join(home, '.local/share/nucleus/versions/')));
assert.equal(JSON.parse(await readFile(join(installed, 'paseo-plugin.json'), 'utf8')).id, 'nucleus');
console.log('manifest=nucleus default-install-id=bridge-discovery-id');
const server = createServer();
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const configPath = join(paseoHome, 'config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.pluginsEnabled = true;
// Discovery knows only `nucleus` (nucleus#971); integrate registered it under that ID.
Object.assign(config.plugins['nucleus'], { source: 'directory', enabled: true });
config.daemon = { listen: `127.0.0.1:${port}`, relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false } };
config.features = { dictation: { enabled: false } };
await writeFile(configPath, JSON.stringify(config));
const paseo = process.env.PASEO_PROOF_CLI || 'paseo';
// The bridge reload command must address this private daemon too.
const paseoPath = (await run('/usr/bin/which', [paseo])).stdout.trim();
const reload = join(root, 'reload-paseo');
await writeFile(reload, `#!/bin/sh\nexec '${paseoPath.replaceAll("'", "'\\''")}' \"$@\" --host 127.0.0.1:${port}\n`, { mode: 0o700 });
env.PASEO_CLI = reload;
let started = false, servicePid;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
try {
  const start = await run(paseo, ['daemon', 'start', '--home', paseoHome]);
  started = true;
  const daemonPid = Number(start.stdout.match(/PID (\d+)/)?.[1]);
  assert.ok(daemonPid, start.stdout);
  const plugins = JSON.parse((await run(paseo, ['plugin', 'ls', '--json', '--host', `127.0.0.1:${port}`])).stdout);
  const plugin = plugins.find(p => p.id === 'nucleus');
  assert.equal(plugin?.status, 'running', JSON.stringify(plugin));
  const identityPath = join(dataHome, 'queue-service.json');
  let identity;
  for (let i = 0; i < 100; i++) {
    try { identity = JSON.parse(await readFile(identityPath, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(r => setTimeout(r, 200)); }
  }
  assert.ok(identity, 'service identity missing');
  servicePid = identity.pid;
  // Service identity and host-run readiness are published independently.
  // Wait for the private endpoint's own evidence rather than racing its bind.
  // A default data home uses the account's host-run root. Here the account
  // HOME is private too; an overridden data home would use <dataHome>/host-run.
  const hostRunRoot = join(home, '.local/state/host-run');
  const authorityPath = join(hostRunRoot, 'authority.json');
  let privateAuthority;
  for (let i = 0; i < 100; i++) {
    try {
      const authority = JSON.parse(await readFile(authorityPath, 'utf8'));
      if (authority.pid === servicePid) { privateAuthority = authority; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(privateAuthority, 'private host-run endpoint did not publish authority for the service');
  assert.ok(privateAuthority.endpoint.startsWith(hostRunRoot + '/'), 'host-run endpoint must stay in the scratch HOME');
  console.log('host-run=private-scratch live-host-run=untouched');
  const command = (await run('/bin/ps', ['-p', String(servicePid), '-o', 'command='])).stdout.trim();
  assert.ok(command.includes(join(current, 'runtime/node')) && command.includes(join(current, 'bin/queue-service.mjs')), command);
  const snapshot = JSON.parse((await run(nucleus, ['snapshot'])).stdout);
  assert.ok(snapshot && typeof snapshot === 'object');
  console.log(`plugin=${plugin.status} service=installed identity=scratch snapshot=answered`);
  console.log(`daemonPid=${daemonPid} servicePid=${servicePid} dictation=disabled`);
  // Force only the settle window, not the build or service handoff. The real
  // private daemon's plugin bridge observes main and invokes the builder.
  await run('git', ['-C', source, '-c', 'user.name=Nucleus proof', '-c', 'user.email=proof@localhost', 'commit', '--allow-empty', '-m', 'Private main-channel roll']);
  const revision = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(dataHome, 'queue-service-roll-request'), 'force\n');
  let rolled = false, roll;
  for (let i = 0; i < 1500; i++) {
    const active = JSON.parse(await readFile(join(current, 'build.json'), 'utf8'));
    try { roll = JSON.parse(await readFile(join(dataHome, 'queue-service-roll.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.notEqual(roll?.status, 'failed', JSON.stringify(roll));
    if (active.revision === revision && roll?.status === 'rolled') { rolled = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(rolled, `private daemon main roll did not land: ${JSON.stringify(roll)}`);
  const oldServicePid = servicePid;
  identity = JSON.parse(await readFile(identityPath, 'utf8'));
  servicePid = identity.pid;
  assert.notEqual(servicePid, oldServicePid, 'main channel must replace the service');
  assert.equal(alive(oldServicePid), false, 'prior service must exit after the handoff');
  await run(join(current, 'runtime/node'), ['--version']);
  assert.ok(JSON.parse((await run(nucleus, ['snapshot'])).stdout));
  await proveInstalledClient(current);
  console.log(`channel=main builder=private-daemon-plugin roll=landed revision=${revision} snapshot=answered`);
  await run(paseo, ['daemon', 'stop', '--home', paseoHome]); started = false;
  if (alive(servicePid)) process.kill(servicePid, 'SIGTERM');
  for (let i = 0; i < 100 && (alive(daemonPid) || alive(servicePid)); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(daemonPid), false, 'daemon still running');
  assert.equal(alive(servicePid), false, 'service still running');
  console.log('cleanup=daemon-and-service-exited');
} finally {
  if (started) await run(paseo, ['daemon', 'stop', '--home', paseoHome]);
  if (servicePid && alive(servicePid)) process.kill(servicePid, 'SIGTERM');
}
